Streamlit Copy Pack

Use this folder when copying estimator data into your Streamlit app.

Files:
- `steak_time_starter.json`
- `reverse_sear_calibration.json`
- `streamlit_app.py` (main Streamlit entry file)
- `requirements.txt`

Recommended target in Streamlit project:
- `data/steak_time_starter.json`
- `data/reverse_sear_calibration.json`

Run locally:
- `streamlit run streamlit-ready/streamlit_app.py`

Exact match mode (same look/behavior as localhost React app):
- Start your Vite app: `npm run dev` (serves `http://localhost:5173`)
- Set env var before launching Streamlit:
  - `export STEAK_FRONTEND_URL="http://localhost:5173"`
- Then run Streamlit app.

For deployed Streamlit:
- Host the React frontend separately (Vercel/Netlify).
- Set Streamlit secret:
  - `frontend_url = "https://your-react-app-url"`
- The Streamlit app will embed that URL for exact UI parity.

Default behavior:
- If no `frontend_url` secret or `STEAK_FRONTEND_URL` env var is set, the app runs in native Streamlit mode.
