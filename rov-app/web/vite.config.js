import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// If deploying to a PROJECT page (https://USER.github.io/REPO/), set base to "/REPO/".
// If deploying to a USER/ORG page (https://USER.github.io/), leave base as "/".
// Override at build time with:  VITE_BASE=/rov-app/ npm run build
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || "/",
});
