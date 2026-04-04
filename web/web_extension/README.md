# Tejaskrit Apply Anywhere — Chrome Extension (MV3)

This extension integrates **directly with the Tejaskrit Firestore schema** used in:
- `web/candidate` (Candidate Panel)
- `web/tpo` (TPO Panel)

It supports:
- Detect job/apply pages
- Extract job info (title/company/location/jdText/applyUrl)
- Autofill application forms from `users/{uid}` + `users/{uid}/master_profile/main`
- Save/Mark applied → writes `jobs/{jobId}` + `applications/{uid}__{jobId}` + `applications/{appId}/logs`
- Optional: Generate tailored resume via Candidate app API (`/api/resume/*`) and download PDF

## Install (unpacked)
1. Unzip this folder.
2. Open `chrome://extensions`
3. Turn ON **Developer mode**
4. Click **Load unpacked** and select the `tejaskrit_extension_pro` folder.

## Setup
### Firebase Auth
In Firebase Console → Authentication → enable **Email/Password**.

### Candidate app URL (needed for resume generation)
Open the extension popup → **Settings** → set:
- **Candidate app URL** (example: `https://<your-candidate-app>.vercel.app`)

This is required because extension runs on any website, so `/api/resume/*` must be called via absolute URL.

## How it writes to Firestore
- `users/{uid}`: ensures base doc exists (role: student, instituteId: null, consents)
- `users/{uid}/master_profile/main`: ensures base doc exists
- `jobs/{jobId}`: created/updated as **private** jobs with `source:"extension"`
- `applications/{uid}__{jobId}`: status saved/applied; origin.type = extension
- `applications/{appId}/logs/{logId}`: records status changes

### jobId strategy
`jobId = ext_<sha256(normalizedApplyUrl)[:22]>`

## Browser constraint
File upload inputs cannot be reliably filled by extensions. The extension downloads the PDF and asks user to upload it manually.
