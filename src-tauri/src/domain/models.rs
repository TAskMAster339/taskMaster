use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Active,
    Completed,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReminderState {
    Pending,
    Fired,
    Missed,
}

#[derive(Debug, Clone)]
pub struct DueReminder {
    pub task_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
    pub archived_at: Option<i64>,
    pub reminder_at: Option<i64>,
    pub reminder_state: Option<ReminderState>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTask {
    pub task: Task,
    pub occurred_at: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDay {
    pub completed: Vec<HistoryTask>,
    pub archived: Vec<HistoryTask>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timer {
    pub id: String,
    pub name: String,
    pub duration_seconds: i64,
    pub remaining_seconds: i64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub reminder_minutes: i64,
    pub archive_hours: i64,
}
