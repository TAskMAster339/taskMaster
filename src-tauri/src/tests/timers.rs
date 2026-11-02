use super::*;

#[test]
fn independent_timers_are_persisted_and_can_run_in_parallel() {
    let store = TaskStore::in_memory().unwrap();
    let first = store.create_timer("Чай", 60, 1_000).unwrap();
    let second = store.create_timer("Перерыв", 180, 1_001).unwrap();
    store.start_timer_at(&first.id, 1_000).unwrap();
    store.start_timer_at(&second.id, 1_001).unwrap();

    let timers = store.list_timers_at(11_000).unwrap();
    assert_eq!(timers.len(), 2);
    assert_eq!(timers[0].name, "Чай");
    assert_eq!(timers[0].remaining_seconds, 50);
    assert_eq!(timers[0].status, "running");
    assert_eq!(timers[1].remaining_seconds, 171);
}

#[test]
fn independent_timer_can_pause_resume_reset_and_finish_once() {
    let store = TaskStore::in_memory().unwrap();
    let timer = store.create_timer("Варка", 60, 1_000).unwrap();
    store.start_timer_at(&timer.id, 1_000).unwrap();
    store.pause_timer_at(&timer.id, 11_000).unwrap();
    assert_eq!(
        store.list_timers_at(100_000).unwrap()[0].remaining_seconds,
        50
    );
    store.start_timer_at(&timer.id, 100_000).unwrap();

    assert!(store.take_due_timers_at(149_999).unwrap().is_empty());
    let due = store.take_due_timers_at(150_000).unwrap();
    assert_eq!(due[0].id, timer.id);
    assert_eq!(due[0].status, "finished");
    assert!(store.take_due_timers_at(151_000).unwrap().is_empty());

    store.reset_timer_at(&timer.id, 151_000).unwrap();
    assert_eq!(
        store.list_timers_at(151_000).unwrap()[0].remaining_seconds,
        60
    );
}

#[test]
fn timer_creation_rejects_empty_names_and_zero_duration() {
    let store = TaskStore::in_memory().unwrap();
    assert!(store.create_timer(" ", 30, 1_000).is_err());
    assert!(store.create_timer("Варка", 0, 1_000).is_err());
    assert!(store.list_timers_at(1_000).unwrap().is_empty());
}

#[test]
fn running_timer_restores_its_remaining_time_after_reopening_the_database() {
    let database = TemporaryDatabase::new();
    let timer_id;
    {
        let store = TaskStore::open(&database.0).unwrap();
        timer_id = store.create_timer("Перерыв", 60, 1_000).unwrap().id;
        store.start_timer_at(&timer_id, 1_000).unwrap();
    }

    let store = TaskStore::open(&database.0).unwrap();
    let restored = store.list_timers_at(11_000).unwrap();
    assert_eq!(restored[0].id, timer_id);
    assert_eq!(restored[0].remaining_seconds, 50);
    assert_eq!(restored[0].status, "running");
}
