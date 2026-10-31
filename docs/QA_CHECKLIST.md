# QA checklist

Manual end-to-end checks against a running frontend, API and worker. Automated coverage is in `tests/`.

## Authentication

| # | Steps | Expected |
|---|---|---|
| A1 | Sign up with a new email and an 8+ character password | Code arrives by email; verify screen shows the address and a 60 s resend countdown |
| A2 | Enter a wrong code | "That code is incorrect." with attempts remaining |
| A3 | Enter 5 wrong codes | "Too many incorrect attempts. Request a new code." |
| A4 | Resend, then enter the new code | Logged in and taken to the upload page |
| A5 | Sign up again with the same (verified) email | "An account with this email already exists" |
| A6 | Log in with a wrong password, then with an unknown email | Same message for both: "Incorrect email or password." |
| A7 | Sign up but don't verify, then log in | Redirected to the verify screen; a fresh code is sent |
| A8 | Reload the upload page | Still logged in (refresh cookie) |
| A9 | Forgot password → code → new password | Back on login with a success notice; old password no longer works; other devices signed out |
| A10 | Log out, then press Back | Login page; the upload page is not reachable |
| A11 | Signup with an invalid email or a 5-character password | Inline field errors, nothing sent |

## Uploads (browser checks)

| # | Steps | Expected |
|---|---|---|
| U1 | Drop a `.txt`, `.gif` or `.webp` file | Shown in the list as "Only JPG, PNG and HEIC photos are allowed."; never uploaded |
| U2 | Choose a file over 25 MB | "Photos must be 25 MB or smaller."; never uploaded |
| U3 | Upload 5+ photos at once | Three upload at a time with progress bars; the rest show "Waiting" |
| U4 | Upload a JPEG/PNG | Local preview straight away, blurred "Checking" card, then a final result without reloading |
| U5 | Upload a HEIC from an iPhone | Placeholder until the server thumbnail is ready, then the converted image |

## Validation results

| # | Photo | Expected |
|---|---|---|
| V1 | Clear selfie or head-and-shoulders photo, one person | Accepted |
| V2 | The same photo again, or a resized/re-saved copy | Rejected: Too similar to another upload |
| V3 | Group photo | Rejected: Multiple faces |
| V4 | Full-body photo from far away | Rejected: Face is too far away |
| V5 | Out-of-focus or motion-blurred face | Rejected: Blurry face detected |
| V6 | Landscape or object with no person | Rejected: No face found |
| V7 | Image under 512 px on its short side | Rejected: Resolution too low |
| V8 | Tiny, heavily compressed file (< 20 KB) | Rejected: File too small |
| V9 | `.exe` or `.txt` renamed to `.jpg` | Rejected: Unsupported file type |
| V10 | Truncated or corrupted JPEG | Rejected: Couldn't read photo |
| V11 | Hover or tab to a reason | Tooltip explains what to change |

## Page behaviour

| # | Steps | Expected |
|---|---|---|
| P1 | Accept 6 photos | Progress bar turns green: "You have enough photos to continue" |
| P2 | Delete a photo | Card disappears straight away; counts update; files removed from S3 |
| P3 | Stop the worker, upload, start the worker | Card stays "Checking", then resolves once the worker is back |
| P4 | Stop the API briefly while photos are processing | Live stream reconnects with backoff; results still appear |
| P5 | Open the page in two tabs, upload in one | Both update live |
| P6 | Phone-width screen | Single column, no sideways scrolling |

## Security spot checks

| # | Steps | Expected |
|---|---|---|
| S1 | Request user A's image id with user B's token | 404 |
| S2 | `curl -X POST /api/v1/auth/refresh -H 'Origin: https://evil.example'` | 403 UNTRUSTED_ORIGIN |
| S3 | Upload to the signed form with a bigger file or a different Content-Type | S3 rejects it |
| S4 | Open an S3 object URL without a signature | AccessDenied |
| S5 | Download the stored display image and inspect EXIF | No GPS or camera metadata |
| S6 | Call `/auth/forgot-password` 11 times for one email within 15 minutes | 429 |
