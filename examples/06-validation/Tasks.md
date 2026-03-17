# Validation Workflow

This example is designed to be run with `--validate` enabled.

```bash
md-todo run examples/06-validation/ --validate --retries 2 --worker opencode run
```

The validation step will check whether each task was really completed, and the correction loop will retry up to 2 times if validation fails.

## Tasks

- [ ] Create a file called `output.txt` containing exactly the text "hello world"
- [ ] Append a second line to `output.txt` containing the current date
- [ ] cli: wc -l output.txt
