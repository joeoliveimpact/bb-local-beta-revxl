# Icons

The extension requires three icon sizes:
- icon16.png (16x16)
- icon48.png (48x48)
- icon128.png (128x128)

## To generate icons:

1. **Option 1: Use an online SVG to PNG converter**
   - Go to https://cloudconvert.com/svg-to-png
   - Upload `icon.svg`
   - Convert to PNG at sizes: 16x16, 48x48, 128x128
   - Rename files to match the required names

2. **Option 2: Use ImageMagick (if installed)**
   ```bash
   magick icon.svg -resize 16x16 icon16.png
   magick icon.svg -resize 48x48 icon48.png
   magick icon.svg -resize 128x128 icon128.png
   ```

3. **Option 3: Use an online icon generator**
   - Go to https://www.favicon-generator.org/
   - Upload the SVG
   - Download the generated icons

## Temporary Workaround

For testing purposes, you can use any PNG images renamed to these filenames. The extension will work without proper icons, but they'll look generic.
