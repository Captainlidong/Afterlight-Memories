import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// eslint-config-next 16 已提供原生 flat config；其中部分槽位为 undefined，需过滤。
const flat = (configs) => configs.filter((c) => c && typeof c === "object");

const eslintConfig = [
  ...flat(nextVitals),
  ...flat(nextTs),
  {
    ignores: [".next/**", "node_modules/**", "data/**", "out/**", "backups/**"],
  },
];

export default eslintConfig;
