# MyLA

A personal tracker for New York State legislation on energy and climate: bills, hearings and budget provisions.

## How it fits together

- **collector/**: Google Apps Script. `bootstrap.gs` is pasted once into a Google Sheet's script editor. It loads `myla_code.js` from a Drive folder and runs it every 5 minutes. When nothing needs doing it exits within seconds. It pulls data from the NY Senate's Open Legislation API and the Legislature's public hearing calendar, keeps a database in Drive, and writes the Sheet, a dashboard data file and an event queue. No AI runs here.
- **claude-check/**: instructions for a scheduled Claude task. It reads the event queue, has a larger model write bill summaries and budget briefs, sends results back through an inbox folder in Drive, and ends with a push notification.
- **dashboard/**: a single-page dashboard. It reads the data file and writes Track and Stop tracking requests through the viewer's Google Drive connector, and can start a check on demand.
- **test/**: a Node harness that mocks the Apps Script services and the Open Legislation API. Run `node test/run.js`.

## Configuration

Drive file and folder IDs, the scheduled task ID and the dashboard URL are placeholders (`YOUR_…`) in this copy. The Open Legislation API key is never stored in code; it lives in the Sheet's Settings tab.
