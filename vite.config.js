export default {
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 }, // big chunks are mermaid internals, loaded only when a diagram appears
};
