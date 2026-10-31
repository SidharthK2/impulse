// Largest-remainder apportionment, ported from the TypeScript alloc.test.ts (impulse-research: tests/engine/).

use impulse_engine::alloc::allocate;

#[test]
fn allocate_sums_to_exactly_the_total() {
    let m = allocate(285_000_000, &[700, 400, 200]).unwrap();
    assert_eq!(m.iter().sum::<i128>(), 285_000_000);
    assert_eq!(m, [153_461_538, 87_692_308, 43_846_154]); // largest remainder gets the extra unit
}

#[test]
fn allocate_gives_each_part_floor_or_ceil_of_its_exact_share() {
    let weights = [3, 7, 11, 1];
    for total in 0..50 {
        let m = allocate(total, &weights).unwrap();
        assert_eq!(m.iter().sum::<i128>(), total);
        for (part, w) in m.iter().zip(weights) {
            let floor = total * w / 22;
            assert!(
                (0..=1).contains(&(part - floor)),
                "total {total}, weight {w}"
            );
        }
    }
}

#[test]
fn allocate_breaks_ties_deterministically_by_input_order() {
    assert_eq!(allocate(1, &[1, 1, 1]).unwrap(), [1, 0, 0]);
}

#[test]
fn allocate_rejects_allocating_something_against_nothing() {
    assert!(allocate(5, &[0, 0]).is_err());
    assert_eq!(allocate(0, &[0, 0]).unwrap().iter().sum::<i128>(), 0);
}
