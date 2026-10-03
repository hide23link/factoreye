"""起動: cd loadtest && python -m emulator  （既定 http://127.0.0.1:8100）"""
import argparse

import uvicorn

from emulator.web import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="FactorEye 負荷テストエミュレータ")
    parser.add_argument("--host", default="127.0.0.1", help="既定は 127.0.0.1（外部に公開しない）")
    parser.add_argument("--port", type=int, default=8100)
    args = parser.parse_args()
    uvicorn.run(create_app(), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
