# Rent and Lease Notification System (RLNS)

RLNS is a web application for automating rent-receipt ingestion, tenant matching, and invoice email dispatch for lease operations.

## Features

- Upload individual rent-receipt PDFs or a multipage master PDF for splitting and processing.
- Extract invoice and tenant details from PDF text, then match receipts to tenants by party code.
- Review, search, rematch, and manage receipts and tenant records.
- Import and export tenant records using spreadsheet and CSV workflows.
- Prepare and dispatch tenant emails in batches, with configurable templates, rate limiting, and delivery logs.
- Monitor receipt, matching, dispatch, and tenant statistics from the dashboard.
- Authenticate users and synchronize tenant records with the configured Oracle database.

## Technology

- Node.js and Express backend with a vanilla JavaScript, HTML, and CSS frontend.
- Oracle Database access through `oracledb` or the optional host bridge.
- PDF processing with `pdf2json`, `pdf-parse`, and `pdf-lib`; spreadsheet handling with `xlsx`.
- Docker Compose and Jenkins deployment configuration.

## Run locally

Use Node.js **22.23.2 or newer**. The installed `pdf2json` version requires that runtime.

```powershell
npm install
npm start
```

Then open [http://localhost:5178](http://localhost:5178). The server listens on port `5178` by default and stores uploaded files under the project’s `uploads` directory.

To use a different port or upload directory, set `PORT` or `ESTATE_BILLS_DIR` before starting the server. The backend must also be able to reach the configured Oracle database for sign-in and database-backed features. Set `ORACLE_CONNECT_STR`, `ORACLE_USER`, and `ORACLE_PASSWORD` for a direct database connection, or configure `HOST_BRIDGE_HOST` and `HOST_BRIDGE_PORT` when using the host bridge.

The checked-in `backend/database.sqlite` file is not used by the current backend; application records are stored in Oracle. Without an accessible Oracle database or host bridge, the static frontend and `/api/health` endpoint can load, but sign-in and data operations will not work.

## Resume summary

Built an internal lease billing and rent-receipt automation system that processes bulk PDF receipts, extracts invoice and tenant metadata, matches receipts to tenant records by party code, and supports review and rematching. Implemented tenant import/export, configurable email templates, rate-limited bulk dispatch, delivery audit logs, dashboard metrics, and Oracle-backed authentication and data synchronization. The application uses a Node.js/Express API and a responsive vanilla JavaScript frontend, with Docker Compose and Jenkins deployment support.
