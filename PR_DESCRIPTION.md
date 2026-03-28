# Add .env.example Files for Backend and Frontend

Closes #232

## Summary

Added machine-readable environment variable reference files so new contributors can get up and running without digging through the README, and CI/CD pipelines have a clear variable manifest.

## Changes

### New Files

| File | Description |
| ---- | ----------- |
| [`frontend/.env.local.example`](frontend/.env.local.example) | Frontend env template with `NEXT_PUBLIC_API_URL` and inline comment |

### Modified Files

| File | Description |
| ---- | ----------- |
| [`README.md`](README.md) | Updated frontend setup step to `cp .env.local.example .env.local` and added new file to project structure |

> `backend/.env.example` and `frontend/.env.example` already existed and are fully documented — no changes needed there.

## Acceptance Criteria

- [x] `backend/.env.example` contains `MONGO_URI`, `STELLAR_NETWORK`, `SCHOOL_WALLET_ADDRESS`, `PORT`
- [x] `frontend/.env.local.example` contains `NEXT_PUBLIC_API_URL`
- [x] Each variable has an inline comment explaining its purpose
- [x] README Getting Started section references the example files
