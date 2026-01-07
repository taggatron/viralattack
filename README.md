# Viral Attack (web prototype)

A lightweight, Plague Inc–style prototype:

- Choose **Bacteria** or **Virus**
- Click the **world map** to choose a start location
- Collect **mutation points** (purple map markers)
- Spend points on **Transmission** and **Symptoms** upgrades

## Run locally

From this folder:

```bash
python3 -m http.server 5173
```

Then open:

- http://localhost:5173/

## Notes

- Uses a simple global simulation model (not country-by-country).
- Map tiles: © OpenStreetMap contributors (attribution shown in UI).
