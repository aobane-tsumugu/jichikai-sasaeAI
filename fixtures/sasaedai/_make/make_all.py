# -*- coding: utf-8 -*-
"""資料の一式を作り直して、開き直して確かめる。

実行: python -X utf8 make_all.py
"""
import sys

import check
import make_judge
import make_related
import make_unrelated

if __name__ == "__main__":
    make_related.main()
    make_unrelated.main()
    make_judge.main()
    sys.exit(check.main())
