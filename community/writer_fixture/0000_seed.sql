CREATE TYPE public.fixture_state AS ENUM ('new', 'ready');
--> statement-breakpoint
CREATE TABLE public.fixture_item (
  id integer PRIMARY KEY,
  label text NOT NULL,
  state public.fixture_state NOT NULL DEFAULT 'new'
);
--> statement-breakpoint
INSERT INTO public.fixture_item (id, label, state) VALUES (1, 'seed', 'new');
