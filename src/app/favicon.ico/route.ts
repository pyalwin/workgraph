const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#111111"/>
  <path d="M18 20h10l4 24 5-16h9" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="18" cy="20" r="5" fill="#f4c430"/>
  <circle cx="32" cy="44" r="5" fill="#39b54a"/>
  <circle cx="46" cy="28" r="5" fill="#4a90e2"/>
</svg>`;

export function GET() {
  return new Response(favicon, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
