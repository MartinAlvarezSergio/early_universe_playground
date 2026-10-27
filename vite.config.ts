import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/early_universe_playground/",
  plugins: [react()]
});
