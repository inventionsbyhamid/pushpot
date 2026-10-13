import { ButtonLink } from "../components/Button";
import { FormGuide } from "../features/guide/FormGuide";
import { PushupDemo } from "../features/guide/PushupDemo";

export default function Guide() {
  return (
    <>
      <section className="pt-8 pb-8">
        <h1 className="font-display text-[clamp(3.6rem,18vw,6rem)] leading-[0.84] font-black uppercase">
          Do it right. Every rep counts.
        </h1>
        <p className="mt-5 max-w-[34ch] text-lg text-chalk/85">
          The camera only counts real reps. Here is exactly what it looks for, and how to set up so
          every one of yours lands.
        </p>
      </section>

      <PushupDemo />
      <FormGuide className="mt-14" />

      <section className="mt-14 grid gap-3" aria-label="Get started">
        <ButtonLink to="/practice" className="min-h-14 text-2xl">
          Practice now
        </ButtonLink>
        <ButtonLink to="/#challenges" variant="secondary" className="min-h-14 text-2xl">
          See challenges
        </ButtonLink>
      </section>
    </>
  );
}
