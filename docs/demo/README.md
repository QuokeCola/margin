# README media

`paper.html` is an original two-column example paper used for the screenshots and the demo GIF
(no third-party papers are shown). To regenerate:

```bash
npm run build
google-chrome --headless=new --no-pdf-header-footer --print-to-pdf=/tmp/demo-paper.pdf "file://$PWD/docs/demo/paper.html"
# start Margin with an empty library on a spare port, add /tmp/demo-paper.pdf, then:
google-chrome --headless=new --window-size=1440,900 --remote-debugging-port=9222 about:blank &
node docs/demo/capture.mjs 9222 http://127.0.0.1:<port>/ /tmp/margin-capture
```

`capture.mjs` writes PNG screenshots and screencast frames (`frames/`, `frames.json`); the GIF is
assembled from the frames with ffmpeg (12 fps, 1100 px wide). It asks one real question, so an API key is needed.
