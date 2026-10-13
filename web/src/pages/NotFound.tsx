import { ButtonLink } from "../components/Button";

export default function NotFound({ message = "This page doesn't exist." }: { message?: string }) {
  return (
    <section className="py-16">
      <p className="font-display text-[7rem] leading-none font-black text-flare">404</p>
      <h1 className="mt-2 font-display text-4xl font-extrabold">Missed rep.</h1>
      <p className="mt-2 text-mute">{message}</p>
      <ButtonLink to="/" className="mt-8 w-full">
        Back to home
      </ButtonLink>
    </section>
  );
}
