# Comic Image Translator Extension

A Firefox extension that automatically translates manga/comic images using the manga-image-translator backend. This is an experimental version for testing purposes.

## ⚠️ Important Notice

**This is an experimental extension for testing purposes only.** 

## Features

- Automatic detection and translation of comic images
- display modes (overlay, replace)
- Batch translation with custom CSS selectors
- Configurable translation settings
- Error handling that gracefully skips problematic images

## Requirements

- Firefox browser
- A running instance of [manga-image-translator backend](https://github.com/zyddnys/manga-image-translator)
- The backend must be accessible at the configured URL (default: http://127.0.0.1:8000)

## Installation

### For Testing

1. Clone or download this repository
2. Open Firefox and navigate to `about:debugging`
3. Click "This Firefox"
4. Click "Load Temporary Add-on..."
5. Select the `manifest.json` file from the downloaded repository

## Setup Instructions

### Backend Setup

1. Install the manga-image-translator backend:
   ```bash
   git clone https://github.com/zyddnys/manga-image-translator.git
   cd manga-image-translator
   pip install -r requirements.txt
   ```

2. Start the backend server:
   ```bash
   cd server
   python main.py --use-gpu
   ```

3. The server will start at `http://127.0.0.1:8000` by default

### Extension Configuration

1. Click the extension icon in your browser toolbar
2. Configure the settings:
   - Backend URL: Ensure it matches your server address
   - Translator: Choose your preferred translator (offline or online)
   - Display Mode: Select how translations should appear
   - CSS Selector: Specify which images to translate automatically

## Usage

### Automatic Translation

1. Configure a CSS selector in the extension settings (default: `[name="image-item"] img`)
2. Enable "Auto-Translation" in the settings
3. The extension will automatically detect and translate images matching your selector

### Manual Translation

1. Right-click on any comic image and select "Translate Image"
2. Or hover over an image and click the translate button (🌐) that appears
3. Or hover over an image and press Alt+T

### Batch Translation

1. Right-click on a page and select "Translate Images with CSS Selector..."
2. Enter one or more CSS selectors to target multiple images
3. Click "Translate Now" to translate all matching images

## API Model Configuration

**Important: The API model settings are not fully configured yet.** 

To use the translation features, you must set up the manga-image-translator backend separately

For offline translators, the models will be downloaded automatically when first used. For online translators, you'll need to configure the appropriate API keys.
