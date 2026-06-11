import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { MainLayout } from "./components/MainLayout";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("WebCut: #root element missing from index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <MainLayout />
  </StrictMode>,
);
