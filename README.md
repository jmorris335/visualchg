# visualchg README

VisualCHG is a extension for visually editing and simulating constraint hypergraphs (CHGs). It works by manipulating a JSON-styled description of a CHG (in a .chg file) in real time.

## Features

- Visual plotting of constraint hypergraphs
- Easy editing and reading
- Execute simulations from a GUI

Describe specific features of your extension including screenshots of your extension in action. Image paths are relative to this README file.

For example if there is an image subfolder under your extension project workspace:

\!\[feature X\]\(images/feature-x.png\)

> Tip: Many popular extensions utilize animations. This is an excellent way to show off your extension! We recommend short, focused animations that are easy to follow.

## Requirements

The editor works off of a `.chg` file: a static JSON representation of a constraint hypergraph. To launch the extension, either open an existing `.chg` file or create a new one.

**Simulation**
All managing and editing of the hypergraph can be done via the extension. However, the simulation featuers require the [ConstraintHg](https://constrainthg.readthedocs.io/en/latest/) package. To do simulation, you'll need to setup a valid Python instance. The best way to do this is by creating a virtual environment, such as the following:

MacOS/Linux:
```bash
    python3 -m venv .venv
    source .venv/bin/activate
    pip install constrainthg
```

Windows:
```shell
    python3 -m venv .venv
    .venv\Scripts\activate
    pip install constrainthg
```

You can also use the VS Code command "Python: Create Environment," just make sure to install ConstraintHg afterwards.

## Extension Settings

Include if your extension adds any VS Code settings through the `contributes.configuration` extension point.

For example:

This extension contributes the following settings:

* `myExtension.enable`: Enable/disable this extension.
* `myExtension.thing`: Set to `blah` to do something.

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

## Release Notes

Users appreciate release notes as you update your extension.

### 1.0.0

Initial release of VisualCHG.

## Authoring Information

