"""Generate PaperLens app icons: orbit (B22) and diamond (B23) from curated-12.html SVG."""
import io
import pathlib
import cairosvg
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "apps/desktop/src-tauri/icons"
ASSET_DIR = ROOT / "apps/desktop/src/assets/icons"
RES_ICON_DIR = ROOT / "apps/desktop/src-tauri/resources/icons"

SVG_ORBIT = '<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg"><rect width="96" height="96" rx="22" fill="#FFF1E2"/><path fill="none" stroke="#17171C" stroke-width="7" stroke-linecap="round" d="M66.8 41.2A20 20 0 1 1 51.5 28.3"/><circle cx="60.9" cy="32.7" r="5.5" fill="#FF7A00"/></svg>'
SVG_DIAMOND = '<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg"><rect width="96" height="96" rx="22" fill="#0D0D11"/><g transform="rotate(45 45 45)"><rect x="30" y="30" width="30" height="30" rx="9" fill="none" stroke="#F2F2EC" stroke-width="7"/></g><g transform="rotate(45 56 56)"><rect x="48" y="48" width="16" height="16" rx="5" fill="#FFD84D"/></g></svg>'

WINDOWS_SIZES = {
    "icon.png": 512,
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "StoreLogo.png": 50,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
}

def render_svg(svg: str, size: int) -> Image.Image:
    png_bytes = cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size, background_color="transparent")
    return Image.open(io.BytesIO(png_bytes)).convert("RGBA")

def ensure_dirs():
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    RES_ICON_DIR.mkdir(parents=True, exist_ok=True)

def main():
    ensure_dirs()
    # Render orbit at 1024 as master, then downscale with LANCZOS for quality
    master_orbit = render_svg(SVG_ORBIT, 1024)
    master_diamond = render_svg(SVG_DIAMOND, 1024)

    # Write Windows icons: default = orbit
    for name, sz in WINDOWS_SIZES.items():
        img = master_orbit.resize((sz, sz), Image.LANCZOS)
        out = ICON_DIR / name
        img.save(out, "PNG")
        print(f"wrote {out} {sz}")

    # icon.ico multi-size (16,24,32,48,64,256) from orbit master
    ico_sizes = [16,24,32,48,64,256]
    frames = [master_orbit.resize((s, s), Image.LANCZOS) for s in ico_sizes]
    # Pillow expects largest first? We give frames[0] as largest? Actually save needs sizes param; use largest.
    # To ensure correct, we save from the largest frame (256) with sizes list.
    largest = master_orbit.resize((256,256), Image.LANCZOS)
    ico_path = ICON_DIR / "icon.ico"
    largest.save(ico_path, sizes=[(s,s) for s in ico_sizes])
    print(f"wrote {ico_path} sizes {ico_sizes}")

    # icon.icns - generate simple via PNG copy as icns if PIL supports, else copy icon.png
    icns_path = ICON_DIR / "icon.icns"
    try:
        # Pillow can save icns on some platforms; try to save with multiple sizes
        # fallback: just write largest png bytes as icns placeholder (not perfect but works for mac placeholder)
        icns_frames = [master_orbit.resize((s,s), Image.LANCZOS) for s in [16,32,128,256,512,1024]]
        # Use 512 as base for icns
        base512 = master_orbit.resize((512,512), Image.LANCZOS)
        base512.save(icns_path, format="ICNS")
        print(f"wrote {icns_path} via ICNS")
    except Exception as e:
        print(f"icns save failed {e}, copying icon.png as fallback")
        # copy 512 png as icns fallback (tauri will ignore on Windows)
        import shutil
        shutil.copy(ICON_DIR / "icon.png", icns_path)

    # Also copy 512 to icon.png already done
    # Write asset icons 256 for frontend
    for name, master in [("orbit", master_orbit), ("diamond", master_diamond)]:
        asset256 = master.resize((256,256), Image.LANCZOS)
        asset_path = ASSET_DIR / f"{name}.png"
        asset256.save(asset_path, "PNG")
        print(f"wrote {asset_path}")

        # resource ico for shortcut IconLocation
        res_ico = RES_ICON_DIR / f"{name}.ico"
        largest_res = master.resize((256,256), Image.LANCZOS)
        largest_res.save(res_ico, sizes=[(s,s) for s in ico_sizes])
        print(f"wrote {res_ico}")

    # Also generate diamond 512 etc for verification? Save orbit/diamond 512 comparison in temp
    # Done

if __name__ == "__main__":
    main()
