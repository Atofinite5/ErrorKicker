import type { Metadata } from "next";
import { HeaderBar } from "./header";
import "./globals.css";

export const metadata: Metadata = {
  title: "ErrorKicker Console",
  description: "Human-in-the-loop review console for the ErrorKicker gate.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100 min-h-screen">
        <HeaderBar />
        <main className="p-6 max-w-6xl mx-auto">{children}</main>
      </body>
    </html>
  );
}
