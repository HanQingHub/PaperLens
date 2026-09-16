"""add source_path to papers for external-open provenance

Revision ID: a7f3d9c1e2b4
Revises: e8a1f2c3b4d5
Create Date: 2026-09-16
"""
from alembic import op
import sqlalchemy as sa

revision = "a7f3d9c1e2b4"
down_revision = "e8a1f2c3b4d5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("papers", schema=None) as batch_op:
        batch_op.add_column(sa.Column("source_path", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("papers", schema=None) as batch_op:
        batch_op.drop_column("source_path")
