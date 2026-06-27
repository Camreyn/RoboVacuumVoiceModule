import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const base = process.env.DESKTOP_BUILD
  ? "./"
  : process.env.GITHUB_REPOSITORY
    ? `/${process.env.GITHUB_REPOSITORY.split("/")[1]}/`
    : "/";

export default defineConfig({
  plugins: [react()],
  base,
  server: {
    port: 5173,
  },
});