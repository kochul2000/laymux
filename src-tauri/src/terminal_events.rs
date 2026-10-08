//! Structured terminal events independent of the GUI process lifetime.
use serde::Serialize;
use std::sync::Arc;

type EventCallback = dyn Fn(&str, serde_json::Value) -> Result<(), String> + Send + Sync;
type OutputParser =
    dyn Fn(&str, &crate::terminal_output::TerminalOutputDelta) -> Result<(), String> + Send + Sync;
type ParserSetup =
    dyn Fn(&str, u64, &crate::terminal::TerminalConfig) -> Result<(), String> + Send + Sync;

#[derive(Clone)]
pub(crate) struct TerminalEvents {
    callback: Arc<EventCallback>,
    parser: Option<Arc<OutputParser>>,
    setup: Option<Arc<ParserSetup>>,
}

pub trait TerminalEventEmitter: Clone + Send + Sync + 'static {
    fn emit<P: Serialize>(&self, event: &str, payload: P) -> Result<(), String>;
}

impl TerminalEvents {
    pub(crate) fn new(
        callback: impl Fn(&str, serde_json::Value) -> Result<(), String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            callback: Arc::new(callback),
            parser: None,
            setup: None,
        }
    }

    pub(crate) fn emit<P: Serialize>(&self, event: &str, payload: P) -> Result<(), String> {
        (self.callback)(
            event,
            serde_json::to_value(payload).map_err(|error| error.to_string())?,
        )
    }

    pub(crate) fn with_output_parser(
        mut self,
        parser: impl Fn(&str, &crate::terminal_output::TerminalOutputDelta) -> Result<(), String>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        self.parser = Some(Arc::new(parser));
        self
    }

    pub(crate) fn has_output_parser(&self) -> bool {
        self.parser.is_some()
    }

    pub(crate) fn with_parser_setup(
        mut self,
        setup: impl Fn(&str, u64, &crate::terminal::TerminalConfig) -> Result<(), String>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        self.setup = Some(Arc::new(setup));
        self
    }

    pub(crate) fn prepare_parser(
        &self,
        id: &str,
        generation: u64,
        config: &crate::terminal::TerminalConfig,
    ) -> Result<(), String> {
        match &self.setup {
            Some(setup) => setup(id, generation, config),
            None => Ok(()),
        }
    }

    pub(crate) fn parse_output(
        &self,
        terminal_id: &str,
        delta: &crate::terminal_output::TerminalOutputDelta,
    ) -> Result<(), String> {
        match &self.parser {
            Some(parser) => parser(terminal_id, delta),
            None => Err("terminal parser is not installed".into()),
        }
    }
}

impl From<tauri::AppHandle> for TerminalEvents {
    fn from(app: tauri::AppHandle) -> Self {
        Self::new(move |event, payload| TerminalEventEmitter::emit(&app, event, payload))
    }
}

impl TerminalEventEmitter for TerminalEvents {
    fn emit<P: Serialize>(&self, event: &str, payload: P) -> Result<(), String> {
        Self::emit(self, event, payload)
    }
}

impl TerminalEventEmitter for tauri::AppHandle {
    fn emit<P: Serialize>(&self, event: &str, payload: P) -> Result<(), String> {
        let payload = serde_json::to_value(payload).map_err(|error| error.to_string())?;
        tauri::Emitter::emit(self, event, payload).map_err(|error| error.to_string())
    }
}
