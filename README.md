# Band Calendar

A web app that shows when your band can rehearse, by checking everyone's Google Calendar availability for the next 3 weeks.

## How it works

```
Browser ──► Node.js server ──GET──► n8n webhook
                                         │
                          Google Calendar FreeBusy API
                                         │
                    ◄── { slots: [...] } ─┘
                         │
                    SQLite DB
                         │
               Calendar UI (rendered from DB)
```

1. Click **Refresh availability** in the UI.
2. The server calls the n8n webhook and waits for the response.
3. n8n checks everyone's Google Calendar for the next 21 days using the FreeBusy API and returns the results.
4. The server stores the results in a local SQLite database.
5. The calendar grid updates and shows who is free on each day.

## Project structure

```
calendar-app/
├── data/                  # SQLite database (persisted, not committed)
├── n8n/
│   ├── availability-workflow.json      # Main n8n workflow to import
│   ├── error-workflow.json             # Error notification workflow
│   └── next-repetitions-original.json # Original Discord-bot workflow
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── .env                   # Local secrets (not committed)
├── .env.example           # Template for .env
├── database.js
├── docker-compose.yml
├── Dockerfile
├── package.json
└── server.js
```

## Time brackets checked

| Day | Window |
|-----|--------|
| Monday – Friday | 18:30 – 21:00 |
| Saturday – Sunday | 15:00 – 19:00 |

These are set in the **Set date brackets** Code node inside the n8n workflow.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) + [Docker Compose](https://docs.docker.com/compose/)
- A running [n8n](https://n8n.io) instance with the Google Calendar OAuth credential configured

## Setup

### 1. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:

| Variable | Description |
|---|---|
| `N8N_WEBHOOK_URL` | Full URL of the n8n webhook (production URL, not test) |
| `N8N_WEBHOOK_USER` | Basic-auth username set on the n8n webhook node |
| `N8N_WEBHOOK_PASS` | Basic-auth password set on the n8n webhook node |
| `PORT` | Port to expose the web app on (default `3000`) |

### 2. Import the n8n workflows

1. In n8n, go to **Workflows → Import** and import `n8n/availability-workflow.json`.
2. Open the workflow and update the Google Calendar credential to your own.
3. Import `n8n/error-workflow.json` (optional — sends error notifications to the server).
4. If you imported the error workflow, note its ID and set it as the **Error Workflow** in the main workflow's settings.
5. Do **not** set the main workflow to Active — it is triggered on demand by the web app.

### 3. Run with Docker

```bash
docker compose up -d
```

The app is now available at `http://your-server:3000`.

The SQLite database is stored in `./data/calendar.db` on the host and mounted into the container, so it survives restarts and rebuilds.

### Running locally (without Docker)

```bash
npm install
npm start
```

## Usage

| Action | Effect |
|---|---|
| **Refresh availability** | Triggers n8n, waits for results (~1–2 min), updates the calendar |
| Click a person's name | Toggle them on/off — calendar re-renders instantly |
| Click a calendar day | Opens a detail panel showing who is free and who is busy |

## People & calendars

The mapping between Google Calendar names and band members is defined in the **Build FreeBusy Request** Code node in n8n (`summaryToName` object). Update it there if someone's calendar name changes.

Current members: Nathan, Raphaël, Yann, Jules, AK.
