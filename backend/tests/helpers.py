"""テストで、ログイン済みの利用者を手早く作るための部品。

パスキー導入前は、/api/auth/register を呼んで利用者とトークンを得ていた。いまの登録は、
メールのリンクと端末のパスキーが要るので、認証そのものを試さないテストは、
DB に直接、利用者・ワークスペース・リフレッシュトークンを作って、トークンを返す。
（認証の流れそのものは、test_passkeys.py が実際の API で試す）
"""
from uuid import UUID, uuid4

from sqlmodel.ext.asyncio.session import AsyncSession

from app import auth as auth_utils
from app.db.models import RefreshToken, User, Workspace
from app.db.session import engine


async def create_user(email: str, workspace_name: str = "WS") -> dict[str, str]:
    """利用者とワークスペースを作り、トークンと ID を返す。

    返す辞書のキー: accessToken, refreshToken, userId, workspaceId。

    パスワードもパスキーも持たない（トークンだけで API を呼べる）。
    """
    async with AsyncSession(engine) as session:
        user = User(email=auth_utils.normalize_email(email))
        session.add(user)
        await session.flush()
        workspace = Workspace(name=workspace_name, owner_id=user.id)
        session.add(workspace)
        await session.flush()
        raw, token_hash = auth_utils.create_refresh_token()
        session.add(
            RefreshToken(
                user_id=user.id,
                workspace_id=workspace.id,
                token_hash=token_hash,
                expires_at=auth_utils.refresh_token_expiry(),
            )
        )
        user_id, workspace_id = user.id, workspace.id
        await session.commit()
    return {
        "accessToken": auth_utils.create_access_token(user_id, workspace_id),
        "refreshToken": raw,
        "userId": str(user_id),
        "workspaceId": str(workspace_id),
    }


def as_uuid(value: str) -> UUID:
    """文字列の ID を UUID にする（テストの読みやすさのため）。"""
    return UUID(value)


def new_email() -> str:
    """重ならないメールアドレス。"""
    return f"user-{uuid4().hex[:10]}@example.com"
