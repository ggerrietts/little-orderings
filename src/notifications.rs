use crate::models::Tier;

pub fn tier_covers(watcher_tier: Tier, event_tier: Tier) -> bool {
    watcher_tier >= event_tier
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broader_tier_covers_narrower_events() {
        assert!(tier_covers(Tier::All, Tier::TaskMilestones));
        assert!(tier_covers(Tier::All, Tier::Milestones));
        assert!(tier_covers(Tier::All, Tier::All));
        assert!(tier_covers(Tier::Milestones, Tier::TaskMilestones));
        assert!(tier_covers(Tier::Milestones, Tier::Milestones));
        assert!(tier_covers(Tier::TaskMilestones, Tier::TaskMilestones));
    }

    #[test]
    fn narrower_tier_does_not_cover_broader_events() {
        assert!(!tier_covers(Tier::TaskMilestones, Tier::Milestones));
        assert!(!tier_covers(Tier::TaskMilestones, Tier::All));
        assert!(!tier_covers(Tier::Milestones, Tier::All));
    }
}
