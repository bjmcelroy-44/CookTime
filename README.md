# Steak Cook Time Estimator (Streamlit)

## Main app file
- `streamlit_app.py`

## Data files
- `steak_time_starter.json`
- `reverse_sear_calibration.json`

## Run locally
```bash
pip install -r requirements.txt
streamlit run streamlit_app.py
```

## Streamlit Cloud
- Main file path: `streamlit_app.py`
- Python dependencies: `requirements.txt`

## Optional exact UI embed mode
If you host the React/Tailwind frontend elsewhere, you can embed it:
- Streamlit secrets:
  - `use_exact_embed = true`
  - `frontend_url = "https://your-frontend-url"`
or
- Environment variable:
  - `STEAK_USE_EMBED=1`
  - `STEAK_FRONTEND_URL=https://your-frontend-url`

If exact embed is not enabled, the app runs in native Streamlit mode.
