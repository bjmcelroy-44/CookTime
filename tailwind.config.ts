import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["'Barlow Semi Condensed'", "'Segoe UI'", "sans-serif"],
        display: ["'Oswald'", "'Segoe UI'", "sans-serif"]
      },
      boxShadow: {
        card: "0 22px 48px rgba(3, 10, 25, 0.34)"
      }
    }
  },
  plugins: []
} satisfies Config;
