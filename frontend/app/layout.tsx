import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Infra Monitor",
  description: "Operations control plane for a fleet of Linux servers"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
