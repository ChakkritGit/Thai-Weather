//! Strict header parsing for the persisted 3-D NumPy uint8 grids.

#[derive(Debug, PartialEq)]
pub struct NpyShape {
    pub steps: usize,
    pub ny: usize,
    pub nx: usize,
}

pub fn parse_npy_header(header: &str) -> Result<NpyShape, &'static str> {
    let compact: String = header
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    if !compact.contains("'descr':'|u1'") || !compact.contains("'fortran_order':False") {
        return Err("invalid uint8 C-order .npy header");
    }
    let shape = compact
        .split_once("'shape':(")
        .and_then(|(_, s)| s.split_once(')'))
        .ok_or("invalid .npy shape")?
        .0;
    let shape: Vec<usize> = shape
        .split(',')
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.parse::<usize>()
                .map_err(|_| "invalid uint8 C-order .npy header")
        })
        .collect::<Result<_, _>>()?;
    if shape.len() != 3
        || shape.contains(&0)
        || shape[0] > 256
        || shape[1].checked_mul(shape[2]).is_none_or(|n| n > 4_000_000)
    {
        return Err("invalid uint8 C-order .npy header");
    }
    Ok(NpyShape {
        steps: shape[0],
        ny: shape[1],
        nx: shape[2],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_only_c_order_byte_arrays_and_bounds_dimensions() {
        let shape =
            parse_npy_header("{'descr': '|u1', 'fortran_order': False, 'shape': (48, 751, 421), }")
                .unwrap_or_else(|_| panic!("valid header"));
        assert_eq!(
            shape,
            NpyShape {
                steps: 48,
                ny: 751,
                nx: 421
            }
        );
        for header in [
            "{'descr':'<f4','fortran_order':False,'shape':(48,751,421)}",
            "{'descr':'|u1','fortran_order':True,'shape':(48,751,421)}",
            "{'descr':'|u1','fortran_order':False,'shape':(48,999999999999,999999999999)}",
            "{'descr':'|u1','fortran_order':False,'shape':(751,421)}",
            "{'descr':'|u1','fortran_order':False,'shape':(48,0,421)}",
        ] {
            assert!(parse_npy_header(header).is_err());
        }
    }
}
