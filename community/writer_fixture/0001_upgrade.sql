ALTER TABLE public.fixture_item ADD COLUMN generation integer NOT NULL DEFAULT 1;
--> statement-breakpoint
UPDATE public.fixture_item SET label = 'seed-upgraded', generation = 2 WHERE id = 1;
--> statement-breakpoint
INSERT INTO public.fixture_item (id, label, state) VALUES (2, 'second', 'ready');
