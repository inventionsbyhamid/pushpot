const PLATFORMS = ["iPhone", "Android"] as const;

/** Native apps are planned; until then the web app installs to the home screen. */
export function AppsComingSoon() {
  return (
    <section
      className="mt-12 rounded-2xl border border-line bg-panel px-4 py-5"
      aria-labelledby="apps-coming-soon"
    >
      <h2 id="apps-coming-soon" className="font-display text-4xl font-extrabold">
        Apps on the way
      </h2>
      <p className="mt-2 text-mute">
        PushPot for iPhone and Android is coming soon. Until then, the web app works on any phone.
        Add it to your home screen and it opens like an app.
      </p>
      <ul className="mt-4 flex flex-wrap gap-3">
        {PLATFORMS.map((platform) => (
          <li
            key={platform}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-raised px-4 text-sm font-semibold"
          >
            <PhoneIcon />
            {platform}
            <span className="rounded-full bg-amber/15 px-2 py-0.5 text-xs text-amber">
              Coming soon
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PhoneIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="size-4 text-volt"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <path d="M10.5 18.5h3" strokeLinecap="round" />
    </svg>
  );
}
