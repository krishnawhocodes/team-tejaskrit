from fastapi import FastAPI, Depends, HTTPException, Security
from fastapi.security.api_key import APIKeyHeader

from bs4 import BeautifulSoup
from datetime import datetime, timezone

import requests
import re
import html
import os
import hashlib

import firebase_admin
from firebase_admin import credentials, firestore


# ---------------------------------------------------
# FIREBASE INITIALIZATION
# ---------------------------------------------------

cred = credentials.Certificate("firebase_credentials.json")
firebase_admin.initialize_app(cred)

db = firestore.client()


# ---------------------------------------------------
# FASTAPI APP
# ---------------------------------------------------

app = FastAPI(title="Tejaskrit Job Scraper & Deduplication API")


# ---------------------------------------------------
# SECURITY (API KEY)
# ---------------------------------------------------

API_KEY = os.getenv("SCRAPER_API_KEY", "my-development-secret-key-123")

api_key_header = APIKeyHeader(name="x-api-key", auto_error=False)


def get_api_key(api_key: str = Security(api_key_header)):
    if api_key == API_KEY:
        return api_key
    raise HTTPException(status_code=403, detail="Invalid or missing API key")


# ---------------------------------------------------
# SCRAPER CONFIG
# ---------------------------------------------------

TARGET_COMPANIES = [
    "figma",
    "discord",
    "dropbox",
    "duolingo"
]


TECH_KEYWORDS = [
    "software",
    "developer",
    "engineer",
    "data",
    "analytics",
    "analyst",
    "machine learning",
    "python",
    "full stack",
    "frontend",
    "backend",
    "cloud",
    "devops",
    "security",
    "it",
    "artificial intelligence",
    "ai",
    "react"
]


# ---------------------------------------------------
# TEXT CLEANING
# ---------------------------------------------------

def clean_html_text(raw_html):

    if not raw_html:
        return "Not specified"

    unescaped_html = html.unescape(raw_html)

    soup = BeautifulSoup(unescaped_html, "html.parser")

    # remove unnecessary sections
    for class_name in [
        "content-intro",
        "content-conclusion",
        "content-pay-transparency"
    ]:

        for section in soup.find_all("div", class_=class_name):
            section.decompose()

    return soup.get_text(separator=" ", strip=True)


# ---------------------------------------------------
# TITLE NORMALIZATION
# ---------------------------------------------------

def normalize_title(title):

    t = title.lower()

    if "react" in t or "frontend" in t:
        return "Frontend Developer"

    if "backend" in t:
        return "Backend Developer"

    if "python" in t:
        return "Python Developer"

    if "data" in t:
        return "Data Engineer"

    if "machine learning" in t or "ai" in t:
        return "AI Engineer"

    return title


# ---------------------------------------------------
# EXTRACT TECH TAGS
# ---------------------------------------------------

def extract_tags(title, description):

    combined = (title + " " + description).lower()

    found = []

    for keyword in TECH_KEYWORDS:

        if re.search(rf"\b{re.escape(keyword)}\b", combined):
            found.append(keyword.title())

    return list(set(found))


# ---------------------------------------------------
# GENERATE DETERMINISTIC JOB ID
# ---------------------------------------------------

def generate_job_id(company, title):

    key = f"{company}-{title}".lower()

    return hashlib.md5(key.encode()).hexdigest()


# ---------------------------------------------------
# CHECK DUPLICATE BY APPLY URL
# ---------------------------------------------------

def job_exists(apply_url):

    docs = db.collection("jobs")\
        .where("applyUrl", "==", apply_url)\
        .limit(1)\
        .get()

    return len(docs) > 0


# ---------------------------------------------------
# CHECK IF TECH JOB
# ---------------------------------------------------

def is_tech_job(title):

    title_lower = title.lower()

    for keyword in TECH_KEYWORDS:

        if re.search(rf"\b{re.escape(keyword)}\b", title_lower):
            return True

    return False


# ---------------------------------------------------
# HEALTH CHECK
# ---------------------------------------------------

@app.get("/")
def health_check():

    return {
        "status": "API is running",
        "message": "Use /sync-jobs endpoint to scrape jobs"
    }


# ---------------------------------------------------
# MAIN JOB SYNC API
# ---------------------------------------------------

@app.get("/sync-jobs")
def sync_scraped_jobs_to_firebase(api_key: str = Depends(get_api_key)):

    try:

        now_iso = datetime.now(timezone.utc).isoformat()

        upload_count = 0

        batch = db.batch()

        # ----------------------------------------------
        # LOOP THROUGH COMPANIES
        # ----------------------------------------------

        for company in TARGET_COMPANIES:

            url = f"https://boards-api.greenhouse.io/v1/boards/{company}/jobs?content=true"

            response = requests.get(url)

            if response.status_code != 200:
                continue

            jobs = response.json().get("jobs", [])

            for job in jobs:

                original_title = job.get("title", "")

                # ------------------------------------------
                # FILTER NON TECH JOBS
                # ------------------------------------------

                if not is_tech_job(original_title):
                    continue

                # ------------------------------------------
                # NORMALIZE TITLE
                # ------------------------------------------

                title = normalize_title(original_title)

                title_lower = title.lower()

                # ------------------------------------------
                # APPLY LINK
                # ------------------------------------------

                apply_url = job.get("absolute_url")

                if not apply_url:
                    continue

                # ------------------------------------------
                # DUPLICATE CHECK
                # ------------------------------------------

                if job_exists(apply_url):
                    continue

                # ------------------------------------------
                # CREATE DETERMINISTIC JOB ID
                # ------------------------------------------

                job_id = generate_job_id(company, title)

                # ------------------------------------------
                # CLEAN DESCRIPTION
                # ------------------------------------------

                raw_html = job.get("content", "")

                clean_description = clean_html_text(raw_html)

                # ------------------------------------------
                # CREATE FIRESTORE DOCUMENT
                # ------------------------------------------

                job_document = {

                    "title": title,

                    "company": company.capitalize(),

                    "location": job.get("location", {}).get(
                        "name",
                        "Remote"
                    ),

                    "jobType": "Internship"
                    if "intern" in title_lower else "Full-time",

                    "applyUrl": apply_url,

                    "jdText": clean_description,

                    "tags": extract_tags(title, clean_description),

                    "sources": ["greenhouse"],

                    "visibility": "public",

                    "status": "open",

                    "postedAt": job.get("updated_at", now_iso),

                    "createdAt": now_iso,

                    "updatedAt": now_iso,

                    "normalized": {

                        "companyLower": company.lower(),

                        "titleLower": title_lower

                    }

                }

                # ------------------------------------------
                # ADD TO BATCH
                # ------------------------------------------

                doc_ref = db.collection("jobs").document(job_id)

                batch.set(doc_ref, job_document)

                upload_count += 1

        # ----------------------------------------------
        # COMMIT BATCH
        # ----------------------------------------------

        if upload_count > 0:
            batch.commit()

        return {

            "status": "success",

            "message": f"{upload_count} jobs inserted into Firebase",

            "synced_count": upload_count

        }

    except Exception as e:

        raise HTTPException(
            status_code=500,
            detail=str(e)
        )