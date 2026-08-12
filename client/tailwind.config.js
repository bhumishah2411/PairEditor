/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ["Manrope", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      colors: {
        // Deep blue-charcoal canvas — never pure black
        canvas: "#10141A",
        panel: {
          DEFAULT: "#161B22",
          raised: "#1D232B",
          sunken: "#0C1015",
        },
        paper: {
          DEFAULT: "#EDEFF2",
          muted: "#8791A3",
          faint: "#5B6270",
        },
        line: "rgba(255,255,255,0.07)",
        // Restrained phosphor-green signal accent — used sparingly
        signal: {
          DEFAULT: "#6FE3A6",
          dim: "rgba(111,227,166,0.12)",
          hover: "#8CEDB9",
        },
        danger: "#E5675C",
        warning: "#E3B564",
        // Retained for compatibility with any legacy references
        surface: {
          900: "#10141A",
          800: "#161B22",
          700: "#1D232B",
          600: "#242B34",
          500: "#2E3644",
        },
        accent: {
          DEFAULT: "#6FE3A6",
          hover: "#8CEDB9",
          glow: "rgba(111,227,166,0.18)",
        },
        success: "#6FE3A6",
        // Author palette — the app's real accent system (matches server USER_COLORS)
        author: [
          "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FECA57",
          "#FF9FF3", "#54A0FF", "#5F27CD", "#00D2D3", "#FF9F43",
        ],
      },
      animation: {
        "fade-in": "fadeIn 0.2s ease-out",
        "slide-up": "slideUp 0.25s ease-out",
        "pulse-dot": "pulseDot 1.4s infinite ease-in-out",
        "spin-slow": "spin 3s linear infinite",
        "cursor-blink": "cursorBlink 1.05s steps(1) infinite",
      },
      keyframes: {
        fadeIn: { "0%": { opacity: 0 }, "100%": { opacity: 1 } },
        slideUp: { "0%": { opacity: 0, transform: "translateY(8px)" }, "100%": { opacity: 1, transform: "translateY(0)" } },
        pulseDot: { "0%,80%,100%": { transform: "scale(0)" }, "40%": { transform: "scale(1)" } },
        cursorBlink: { "0%,49%": { opacity: 1 }, "50%,100%": { opacity: 0 } },
      },
      borderRadius: {
        sm: "4px",
        DEFAULT: "6px",
        md: "6px",
        lg: "8px",
      },
      backdropBlur: { xs: "2px" },
    },
  },
  plugins: [],
};
