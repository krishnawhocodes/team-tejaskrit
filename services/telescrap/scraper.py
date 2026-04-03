import asyncio
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

from dotenv import load_dotenv
from groq import Groq
from telethon import TelegramClient
from telethon.errors import FloodWaitError, UserAlreadyParticipantError
from telethon.tl.functions.channels import JoinChannelRequest

import firebase_admin
from firebase_admin import credentials, firestore


# ─────────────────────────────────────────────
# ⚙️ CONFIGURATION — loaded from .env
# ─────────────────────────────────────────────
load_dotenv()

API_ID = int(os.getenv("API_ID"))
API_HASH = os.getenv("API_HASH")
PHONE_NUMBER = os.getenv("PHONE_NUMBER")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

FIREBASE_CREDENTIALS_FILE = os.getenv("FIREBASE_CREDENTIALS_FILE", "firebase_credentials.json")
TARGET_COLLECTION = "jobs"
OUTPUT_FILE = "jobs.json"
TARGET_CHANNELS = [
    "getjobss",
]
MESSAGES_TO_FETCH = 30
VALID_JOB_GOAL = 5
GROQ_MODEL = "llama-3.3-70b-versatile"

TECH_KEYWORDS = [
    "software", "developer", "engineer", "data", "analytics", "analyst",
    "machine learning", "python", "full stack", "frontend", "backend",
    "cloud", "devops", "security", "it", "artificial intelligence", "ai",
    "react", "intern", "internship", "sde", "programmer", "qa", "testing"
]

SYSTEM_PROMPT = """You are a strict job listing parser and spam classifier for Telegram messages.

Your ONLY task is to evaluate whether a given Telegram message is a legitimate job or internship posting, then respond with a single JSON object — nothing else.

## CLASSIFICATION RULES

A message is VALID if it:
- Advertises a specific job role, internship, freelance gig, or hiring opportunity
- Contains at least one of: job title, company name, role description, apply link, or clear hiring call-to-action

A message is INVALID (spam) if it:
- Promotes a product, service, course, or investment scheme
- Is a news update, announcement, or general info post
- Is a forwarded ad, referral link, or crypto/trading promotion
- Contains no actionable hiring information

## OUTPUT FORMAT

If INVALID, return ONLY:
{"status": "invalid", "reason": "<one short sentence explaining why>"}

If VALID, return ONLY:
{"status": "valid", "job_title": "<title or null>", "company_name": "<company or null>", "location": "<location or null>", "job_type": "<Full-time | Part-time | Internship | Freelance | Contract | null>", "salary_or_stipend": "<amount/range as string or null>", "apply_link": "<URL or null>"}

## STRICT RULES
- Output raw JSON only. No markdown, no code fences, no prose, no explanation outside the JSON.
- Use null (not \"null\", not \"N/A\", not \"\") for any field that is missing or unclear.
- Never hallucinate a field. If you cannot find a value, use null.
- Do not merge or summarize multiple jobs from one message. Evaluate the message as a single unit."""


# ─────────────────────────────────────────────
# 🔥 FIREBASE SETUP — SAME AS main.py
# ─────────────────────────────────────────────
def get_firestore_client() -> firestore.Client:
    if not firebase_admin._apps:
        cred = credentials.Certificate(FIREBASE_CREDENTIALS_FILE)
        firebase_admin.initialize_app(cred)
    return firestore.client()


# ─────────────────────────────────────────────
# 🤖 GROQ CLASSIFIER
# ─────────────────────────────────────────────
def classify_message(groq_client: Groq, message_text: str) -> dict[str, Any] | None:
    raw = ""
    try:
        response = groq_client.chat.completions.create(
            model=GROQ_MODEL,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": message_text},
            ],
            temperature=0,
            max_tokens=350,
        )
        raw = response.choices[0].message.content or ""
        return json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"    ⚠️ JSON parse error: {e} — raw: {raw[:160]}")
        return None
    except Exception as e:
        print(f"    ⚠️ Groq API error: {e}")
        return None


# ─────────────────────────────────────────────
# 🧹 TEXT / NORMALIZATION HELPERS
# ─────────────────────────────────────────────
def clean_text(text: str | None) -> str:
    if not text:
        return "Not specified"
    text = re.sub(r"\s+", " ", text).strip()
    return text or "Not specified"


def extract_tags(title: str, description: str) -> list[str]:
    combined_text = f"{title} {description}".lower()
    found_tags = [kw.title() for kw in TECH_KEYWORDS if re.search(rf"\b{re.escape(kw)}\b", combined_text)]
    return sorted(set(found_tags))


def infer_job_type(llm_job_type: str | None, title: str, description: str) -> str:
    if llm_job_type:
        return llm_job_type

    combined = f"{title} {description}".lower()
    if "intern" in combined or "internship" in combined:
        return "Internship"
    if "freelance" in combined:
        return "Freelance"
    if "contract" in combined:
        return "Contract"
    if "part-time" in combined or "part time" in combined:
        return "Part-time"
    return "Full-time"


def build_external_id(channel: str, message_id: int) -> str:
    safe_channel = re.sub(r"[^a-zA-Z0-9_]+", "_", channel.lstrip("@"))
    return f"tg-{safe_channel}-{message_id}"


def build_company_fallback(channel: str) -> str:
    base = channel.lstrip("@").replace("_", " ").replace("-", " ").strip()
    return base.title() if base else "Telegram"


def first_url(text: str) -> str | None:
    match = re.search(r"https?://\S+", text)
    return match.group(0).rstrip('.,)') if match else None


def normalize_telegram_job(parsed: dict[str, Any], message_text: str, channel: str, message_id: int, now_iso: str) -> dict[str, Any]:
    title = clean_text(parsed.get("job_title"))
    if title == "Not specified":
        title = "Untitled Job"

    company = clean_text(parsed.get("company_name"))
    if company == "Not specified":
        company = build_company_fallback(channel)

    location = clean_text(parsed.get("location"))
    if location == "Not specified":
        location = "Remote"

    apply_url = parsed.get("apply_link") or first_url(message_text)
    job_type = infer_job_type(parsed.get("job_type"), title, message_text)
    external_id = build_external_id(channel, message_id)
    clean_description = clean_text(message_text)
    title_lower = title.lower()

    return {
        "title": title,
        "company": company,
        "location": location,
        "jobType": job_type,
        "applyUrl": apply_url,
        "jdText": clean_description,
        "tags": extract_tags(title, clean_description),
        "source": "telegram",
        "sourceMeta": {
            "sourceId": "scrape_sources/telegram",
            "externalId": external_id,
            "channel": channel,
            "messageId": message_id,
        },
        "visibility": "public",
        "instituteId": None,
        "ownerUid": None,
        "status": "open",
        "postedAt": now_iso,
        "lastSeenAt": now_iso,
        "createdAt": now_iso,
        "updatedAt": now_iso,
        "normalized": {
            "companyLower": company.lower(),
            "titleLower": title_lower,
        },
    }


# ─────────────────────────────────────────────
# 📡 TELEGRAM HELPERS
# ─────────────────────────────────────────────
async def safe_join(client: TelegramClient, channel: str) -> bool:
    try:
        await client(JoinChannelRequest(channel))
        print(f"  ✅ Joined: {channel}")
        return True
    except UserAlreadyParticipantError:
        print(f"  ℹ️ Already a member: {channel}")
        return True
    except FloodWaitError as e:
        print(f"  🚫 Flood wait for {e.seconds}s on {channel} — skipping.")
        return False
    except Exception as e:
        print(f"  🚫 Could not join {channel}: {e}")
        return False


# ─────────────────────────────────────────────
# 🚀 MAIN ORCHESTRATOR
# ─────────────────────────────────────────────
async def main() -> None:
    db = get_firestore_client()
    groq_client = Groq(api_key=GROQ_API_KEY)
    saved_jobs: list[dict[str, Any]] = []

    client = TelegramClient("scraper_session", API_ID, API_HASH)
    await client.start(phone=PHONE_NUMBER)
    print("✅ Telegram client connected.\n")
    print(f"🔥 Firebase connected. Collection: {TARGET_COLLECTION}\n")

    try:
        print("📡 Joining target channels...")
        joined_channels: list[str] = []

        for idx, channel in enumerate(TARGET_CHANNELS):
            joined = await safe_join(client, channel)
            if joined:
                joined_channels.append(channel)
            if idx < len(TARGET_CHANNELS) - 1:
                print("   ⏳ Sleeping 5 s to avoid flood ban...")
                await asyncio.sleep(5)

        if not joined_channels:
            print("\n❌ Could not join any channels. Exiting.")
            return

        print()
        print(f"🔍 Scraping messages (goal: {VALID_JOB_GOAL} valid jobs)...\n")
        batch = db.batch()
        outer_break = False

        for channel in joined_channels:
            if outer_break:
                break

            print(f"📂 Channel: {channel}")

            try:
                async for message in client.iter_messages(channel, limit=MESSAGES_TO_FETCH):
                    if not message.text or not message.text.strip():
                        continue

                    print(f"  📨 Msg {message.id} — classifying...")
                    result = classify_message(groq_client, message.text)

                    if result is None:
                        print("     ↳ Skipped (parse failure)")
                        continue

                    status = result.get("status")

                    if status == "invalid":
                        print(f"     ↳ SPAM — {result.get('reason', 'no reason given')}")
                        continue

                    if status != "valid":
                        print("     ↳ Skipped (unknown status)")
                        continue

                    now_iso = datetime.now(timezone.utc).isoformat()
                    job_document = normalize_telegram_job(
                        parsed=result,
                        message_text=message.text,
                        channel=channel,
                        message_id=message.id,
                        now_iso=now_iso,
                    )

                    external_id = job_document["sourceMeta"]["externalId"]
                    doc_ref = db.collection(TARGET_COLLECTION).document(external_id)
                    batch.set(doc_ref, job_document)
                    saved_jobs.append(job_document)

                    count = len(saved_jobs)
                    print(f"     ↳ ✅ VALID JOB #{count}: {job_document['title']} @ {job_document['company']}")

                    if count >= VALID_JOB_GOAL:
                        print(f"\n🎯 Goal reached! {VALID_JOB_GOAL} valid jobs found. Stopping.\n")
                        outer_break = True
                        break

            except Exception as e:
                print(f"  ⚠️ Error scraping {channel}: {e} — skipping.\n")
                continue

        if saved_jobs:
            batch.commit()
            print(f"🔥 Uploaded {len(saved_jobs)} job(s) to Firestore collection '{TARGET_COLLECTION}'.")

    finally:
        await client.disconnect()
        print("🔌 Telegram client disconnected.")

    if saved_jobs:
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            json.dump(saved_jobs, f, indent=2, ensure_ascii=False)
        print(f"💾 Saved {len(saved_jobs)} normalized job(s) to '{OUTPUT_FILE}'")
    else:
        print("⚠️ No valid jobs found across all channels.")


if __name__ == "__main__":
    asyncio.run(main())