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
        canvas: "rgb(var(--color-canvas) / <alpha-value>)",
        panel: {
          DEFAULT: "rgb(var(--color-panel) / <alpha-value>)",
          raised: "rgb(var(--color-panel-raised) / <alpha-value>)",
          sunken: "rgb(var(--color-panel-sunken) / <alpha-value>)",
        },
        paper: {
          DEFAULT: "rgb(var(--color-paper) / <alpha-value>)",
          muted: "rgb(var(--color-paper-muted) / <alpha-value>)",
          faint: "rgb(var(--color-paper-faint) / <alpha-value>)",
        },
        line: ({ opacityValue }) => {
          if (opacityValue !== undefined) {
            return `rgb(var(--color-line) / ${Math.min(Number(opacityValue), 0.25)})`;
          }
          return `rgb(var(--color-line) / var(--color-line-alpha, 0.08))`;
        },
        signal: {
          DEFAULT: "rgb(var(--color-signal) / <alpha-value>)",
          dim: "var(--color-signal-dim)",
          hover: "rgb(var(--color-signal-hover) / <alpha-value>)",
        },
        danger: "rgb(var(--color-danger) / <alpha-value>)",
        warning: "rgb(var(--color-warning) / <alpha-value>)",
        surface: {
          900: "rgb(var(--color-canvas) / <alpha-value>)",
          800: "rgb(var(--color-panel) / <alpha-value>)",
          700: "rgb(var(--color-panel-raised) / <alpha-value>)",
          600: "rgb(var(--color-panel-raised) / <alpha-value>)",
          500: "rgb(var(--color-paper-faint) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--color-signal) / <alpha-value>)",
          hover: "rgb(var(--color-signal-hover) / <alpha-value>)",
          glow: "var(--color-signal-dim)",
        },
        success: "rgb(var(--color-signal) / <alpha-value>)",
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
