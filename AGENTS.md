# Notes for agents working on Parlella

- Public plugin: no NakliOS imports, no local paths or private conventions in shipped files. Dish-specific glue lives in the NakliOS repo, not here.
- Reimplement from the four source plugins' behaviour; never copy their code. Record which idea came from where in commit messages.
- Every inbound peer message carries the no-authority stamp; staged writes and approvals never pass through a peer message.

## Verification budget

- No tests, evals or diagnostics between implementation steps. Build the whole batch, then check it once at the batch boundary. A batch is one capability family, about a day of work.
- Run only the checks that cover the changed batch; never repeat an unchanged suite.
- All generated test data goes to one temp directory, capped at 5,000 files and 500 MB, preferring one aggregate file; delete it on success, failure and interrupt.
- One diagnostic batch per failure, naming two to four hypotheses before it runs; no second batch without a hypothesis the first did not cover.
- No new process tooling (receipts, provenance, locks) until a feature it gates exists.
- Log anything over 50 MB or 1,000 files to the session ledger when it is created.
