import Handlebars from "handlebars";

/** Isolated Handlebars instance — never touches the global registry. */
const hbs = Handlebars.create();

// -- Comparison --
hbs.registerHelper("eq", (a: unknown, b: unknown) => a === b);
hbs.registerHelper("ne", (a: unknown, b: unknown) => a !== b);
hbs.registerHelper(
	"lt",
	(a: unknown, b: unknown) => (a as number) < (b as number),
);
hbs.registerHelper(
	"gt",
	(a: unknown, b: unknown) => (a as number) > (b as number),
);

// -- Logic --
hbs.registerHelper("and", (...args: unknown[]) =>
	(args.slice(0, -1) as unknown[]).every(Boolean),
);
hbs.registerHelper("or", (...args: unknown[]) =>
	(args.slice(0, -1) as unknown[]).some(Boolean),
);
hbs.registerHelper("not", (a: unknown) => !a);

// -- Utility --
hbs.registerHelper(
	"default",
	(val: unknown, fallback: unknown) => val || fallback,
);
hbs.registerHelper("join", (arr: unknown, sep: unknown) =>
	Array.isArray(arr) ? arr.join(String(sep)) : arr,
);

export { hbs };
