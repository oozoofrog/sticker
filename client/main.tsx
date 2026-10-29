import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles.css";
import "./features/mcp-settings/mcp-settings.css";
import "./features/agent-install/agent-install.css";
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root.");
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import "./features/relations/relations.css";

import "./features/releases/releases.css";

import "./features/history/history.css";
