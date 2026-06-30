export const metadata = { title: "Calculator Alocare BET", description: "Alocare proporțională top 10 BET" };
export default function RootLayout({ children }) {
  return (
    <html lang="ro">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />
        <style>{`*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0f1a}`}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
