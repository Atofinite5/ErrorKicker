import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ErrorKicker Console",
  description: "Human-in-the-loop review console for the ErrorKicker gate.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100 min-h-screen">
        <header className="border-b border-slate-800 px-6 py-4 flex items-center gap-3">
          <span className="text-2xl">🥋</span>
          <div>
            <h1 className="font-bold text-lg leading-none">ErrorKicker</h1>
            <p className="text-xs text-slate-400">the bouncer behind your cache</p>
          </div>
          <nav className="ml-8 flex gap-4 text-sm">
            <a href="/" className="text-slate-300 hover:text-white">Dashboard</a>
          </nav>
        </header>
        <main className="p-6 max-w-6xl mx-auto">{children}</main>
      </body>
    </html>
  );
}
