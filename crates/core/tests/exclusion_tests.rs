use vimium_core::keys::{ExclusionFilter, ExclusionRule, KeyModifiers, KeyStroke};

#[test]
fn test_glob_url_matching_with_pass_keys() {
    let rules = vec![
        ExclusionRule {
            pattern: "https://mail.google.com/*".to_string(),
            pass_keys: "jkgi".to_string(),
        },
        ExclusionRule {
            pattern: "https://docs.google.com/*".to_string(),
            pass_keys: String::new(), // Disabled entirely
        },
    ];

    // Matched URL with specific passKeys
    let filter = ExclusionFilter::for_url(&rules, "https://mail.google.com/mail/u/0/#inbox");
    assert!(filter.is_passed(KeyStroke::from_ascii(b'j')));
    assert!(filter.is_passed(KeyStroke::from_ascii(b'k')));
    assert!(filter.is_passed(KeyStroke::from_ascii(b'g')));
    assert!(filter.is_passed(KeyStroke::from_ascii(b'i')));
    assert!(!filter.is_passed(KeyStroke::from_ascii(b'f'))); // Hints key not passed
    assert!(!filter.is_passed(KeyStroke::from_ascii(b'o')));

    // Modifiers should NOT pass through (they remain intercepted or distinct)
    let ctrl_j = KeyStroke::new(b'j', KeyModifiers::CTRL);
    assert!(!filter.is_passed(ctrl_j));

    // Fully disabled URL
    let disabled_filter = ExclusionFilter::for_url(&rules, "https://docs.google.com/document/d/123/edit");
    assert!(disabled_filter.is_passed(KeyStroke::from_ascii(b'j')));
    assert!(disabled_filter.is_passed(KeyStroke::from_ascii(b'f')));

    // Unmatched URL -> default active (no keys passed)
    let default_filter = ExclusionFilter::for_url(&rules, "https://news.ycombinator.com");
    assert!(!default_filter.is_passed(KeyStroke::from_ascii(b'j')));
    assert!(!default_filter.is_passed(KeyStroke::from_ascii(b'k')));
}

#[test]
fn test_wildcard_domain_patterns() {
    let rules = vec![ExclusionRule {
        pattern: "https://*.github.com/*".to_string(),
        pass_keys: "t".to_string(),
    }];

    let filter = ExclusionFilter::for_url(&rules, "https://gist.github.com/c4kar");
    assert!(filter.is_passed(KeyStroke::from_ascii(b't')));
    assert!(!filter.is_passed(KeyStroke::from_ascii(b'j')));
}
