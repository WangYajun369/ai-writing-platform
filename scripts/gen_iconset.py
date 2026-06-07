"""从 icon.png 源文件生成 macOS iconset"""
from PIL import Image

sizes = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
}

src = Image.open("src-tauri/icons/icon.png")
out = "src-tauri/icons/iconset"

for name, size in sizes.items():
    img = src.resize((size, size), Image.LANCZOS)
    img.save(f"{out}/{name}", "PNG")
    print(f"  ✅ {name} ({size}×{size})")

print("iconset 全部更新完成！")
