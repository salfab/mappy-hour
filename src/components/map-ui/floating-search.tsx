"use client";

import { FormEvent, useEffect, useRef } from "react";

import { CloseIcon, SearchIcon } from "./icons";

interface FloatingSearchProps {
  isOpen: boolean;
  query: string;
  isLoading: boolean;
  error: string | null;
  onOpen: () => void;
  onClose: () => void;
  onQueryChange: (query: string) => void;
  onSubmit: () => void;
}

export function FloatingSearch(props: FloatingSearchProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (props.isOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [props.isOpen]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    props.onSubmit();
  };

  if (!props.isOpen) {
    return (
      <button
        type="button"
        className="absolute right-4 top-4 z-[500] grid h-12 w-12 place-items-center rounded-full border border-white/25 bg-slate-950/70 text-white shadow-xl backdrop-blur transition hover:bg-slate-900/85 lg:hidden"
        aria-label="Rechercher un lieu"
        onClick={props.onOpen}
      >
        <SearchIcon />
      </button>
    );
  }

  return (
    <form
      className="absolute left-4 right-4 top-4 z-[500] grid gap-2 rounded-2xl border border-white/25 bg-slate-950/88 p-2 shadow-2xl backdrop-blur lg:hidden"
      onSubmit={handleSubmit}
    >
      <div className="flex items-center gap-2">
        <SearchIcon className="h-5 w-5 shrink-0 text-slate-300" />
        <input
          ref={inputRef}
          className="min-w-0 flex-1 rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-base text-white outline-none placeholder:text-slate-400 focus:border-yellow-300"
          value={props.query}
          placeholder="Chercher une adresse ou un lieu"
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
        <button
          type="button"
          className="grid h-10 w-10 place-items-center rounded-full text-slate-200 transition hover:bg-white/10"
          aria-label="Fermer la recherche"
          onClick={props.onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <button
        type="submit"
        className="rounded-xl bg-yellow-300 px-4 py-2 text-sm font-semibold text-black transition hover:bg-yellow-200 disabled:cursor-not-allowed disabled:bg-slate-500"
        disabled={props.isLoading || props.query.trim().length === 0}
      >
        {props.isLoading ? "Recherche..." : "Rechercher"}
      </button>
      {props.error ? <p className="px-1 text-xs text-rose-200">{props.error}</p> : null}
    </form>
  );
}
