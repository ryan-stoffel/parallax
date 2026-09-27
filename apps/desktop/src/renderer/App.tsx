import { useEffect, useState } from "react";

// Placeholder window. RYA-13 builds the real layout.
export function App() {
  const [version, setVersion] = useState("");

  useEffect(() => {
    void window.wisp.version().then(setVersion);
  }, []);

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-2 bg-neutral-950 text-neutral-100">
      <h1 className="text-2xl font-medium">wisp</h1>
      <p className="text-sm text-neutral-500">
        {version} on {window.wisp.platform}
      </p>
    </main>
  );
}
