/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        om: {
          bg: "#edf2ff",
          ink: "#0f172a",
          blue: "#1a73e8",
          cyan: "#0891b2",
          soft: "#dbeafe"
        }
      },
      boxShadow: {
        float: "0 16px 48px rgba(15, 23, 42, 0.16)"
      }
    }
  },
  plugins: []
};
