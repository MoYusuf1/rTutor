export default {
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022", chunkSizeWarningLimit: 3000 }, // the one big chunk is mermaid, loaded only when a diagram appears
  plugins: [
    {
      // WebKit reads woff2; drop KaTeX's legacy woff/ttf copies of every math font
      name: "katex-woff2-only",
      enforce: "pre", // before Vite resolves the url()s into bundled assets
      transform(code, id) {
        if (id.endsWith("katex.min.css")) return code.replace(/,url\([^)]+\.(woff|ttf)\) format\("(woff|truetype)"\)/g, "");
      },
    },
  ],
};
