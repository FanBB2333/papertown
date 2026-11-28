"""Entry point used by Papertown servers to launch their persistent PTY host."""
import argparse

from teletty.ptyd import add_arguments, run

from .terminal_compat import EXIT_NOTE, MESSAGES, TERM_NAME


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m papertown.ptyd")
    add_arguments(parser)
    parser.set_defaults(term_name=TERM_NAME, exit_note=EXIT_NOTE, messages=MESSAGES)
    return run(parser.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
